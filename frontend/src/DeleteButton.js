import DeleteIcon from "@mui/icons-material/Delete";
import FormControlLabel from "@material-ui/core/FormControlLabel";
import IconButton from "@material-ui/core/IconButton";


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
