import DeleteIcon from "@mui/icons-material/Delete";
import FormControlLabel from "@mui/material/FormControlLabel";
import IconButton from "@mui/material/IconButton";


const DeleteButton = ({ onClick }) => {
    return (
        <FormControlLabel
            sx={{ mr: 0, ml: 0 }}
            control={
                <IconButton onClick={onClick}>
                    <DeleteIcon />
                </IconButton>
            }
        />
    );
};

export default DeleteButton;
