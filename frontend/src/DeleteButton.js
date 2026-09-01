import DeleteIcon from "@mui/icons-material/Delete";
import FormControlLabel from "@mui/material/FormControlLabel";
import IconButton from "@mui/material/IconButton";


const DeleteButton = ({ onClick }) => {
    return (
        <FormControlLabel
            control={
                <IconButton onClick={onClick}>
                    <DeleteIcon />
                </IconButton>
            }
        />
    );
};

export default DeleteButton;
